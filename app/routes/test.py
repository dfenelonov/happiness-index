"""Согласие и прохождение теста: вопрос на экран, HTMX, «назад», продолжение по cookie."""

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session as DbSession

from app.db.models import Session
from app.db.session import Db
from app.scoring import ScoringError
from app.services.events import log_event, log_event_once
from app.services.results import complete, result_of, save_answer, stored_answers
from app.services.sessions import ensure_session, get_session, give_consent, set_sid_cookie
from app.services.test_flow import AnswerError, TestFlow
from app.web import is_htmx, redirect, render

router = APIRouter()


def _flow(request: Request) -> TestFlow:
    return request.app.state.test_flow


def _render_consent(request: Request, error: str | None = None, status: int = 200):
    return render(
        request, "test/page.html", {"partial": "test/_consent.html", "error": error}, status
    )


def _render_question(
    request: Request,
    db: DbSession,
    session: Session,
    item_id: str,
    carried: dict[str, str],
    error: str | None = None,
    status: int = 200,
):
    question = _flow(request).question(item_id)
    if question.index == 0:
        log_event_once(db, session, "test_start")
    current = (
        carried.get(item_id) if not question.stored else stored_answers(db, session).get(item_id)
    )
    context = {
        "question": question,
        "current": current,
        "carry": {k: v for k, v in carried.items() if k != item_id},
        "error": error,
    }
    if is_htmx(request):
        return render(request, "test/_question.html", context, status)
    return render(request, "test/page.html", {"partial": "test/_question.html", **context}, status)


def _active_session(request: Request, db: DbSession) -> Session | None:
    session = get_session(db, request, request.app.state.settings)
    return session if session and session.consent_at else None


@router.get("/test", response_class=HTMLResponse)
def test_page(request: Request, db: Db):
    session = _active_session(request, db)
    if session is None:
        return _render_consent(request)
    if result := result_of(db, session):
        return redirect(request, f"/r/{result.public_id}")
    item_id = _flow(request).resume_id(set(stored_answers(db, session)))
    return _render_question(request, db, session, item_id, {})


@router.post("/consent")
async def consent(request: Request, db: Db):
    settings = request.app.state.settings
    form = await request.form()
    session, sid = ensure_session(db, request, settings)
    if form.get("agree") != "yes":
        response = _render_consent(request, "Чтобы начать, отметь согласие.", 400)
    else:
        version = request.app.state.app_config.consent.version
        give_consent(db, session, version)
        log_event(db, session, "consent_given", version=version)
        response = redirect(request, "/test")
    set_sid_cookie(response, sid, settings)
    return response


@router.post("/api/answers", response_class=HTMLResponse)
async def answer(request: Request, db: Db):
    session = _active_session(request, db)
    if session is None:
        return redirect(request, "/test")
    if result := result_of(db, session):
        return redirect(request, f"/r/{result.public_id}")

    flow = _flow(request)
    form = await request.form()
    item_id = form.get("item_id")
    if not isinstance(item_id, str) or item_id not in flow:
        raise HTTPException(400, "Неизвестный вопрос")
    try:
        carried = flow.carried(form)
    except AnswerError:
        raise HTTPException(400, "Некорректные ответы") from None

    if form.get("action") == "back":
        return _render_question(request, db, session, flow.prev_id(item_id) or item_id, carried)

    try:
        value = flow.validate(item_id, form.get("value"))
    except AnswerError:
        return _render_question(
            request, db, session, item_id, carried, "Выбери один из вариантов", 422
        )
    if flow.is_stored(item_id):
        save_answer(db, session, item_id, value)
    else:
        carried[item_id] = value
    answered = flow.question(item_id)
    log_event(db, session, "question_answered", index=answered.number, block=answered.block.id)

    next_id = flow.next_id(item_id)
    if next_id is None:
        context = {"carry": carried}
        if is_htmx(request):
            return render(request, "test/_finish.html", context)
        return render(request, "test/page.html", {"partial": "test/_finish.html", **context})
    return _render_question(request, db, session, next_id, carried)


@router.post("/test/complete")
async def test_complete(request: Request, db: Db):
    session = _active_session(request, db)
    if session is None:
        return redirect(request, "/test")
    if result := result_of(db, session):
        return redirect(request, f"/r/{result.public_id}")
    form = await request.form()
    try:
        carried = _flow(request).carried(form)
        result = complete(db, request.app.state.questionnaire, session, carried)
    except (AnswerError, ScoringError):
        return redirect(request, "/test")
    return redirect(request, f"/r/{result.public_id}")
