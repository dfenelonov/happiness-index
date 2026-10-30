"""Платный отчёт по секретной ссылке: /report/{token} и PDF, фейковая дверь. SPEC §3.6."""

from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, Response
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.db.models import Lead, Order, Report, Result, Session
from app.db.session import Db
from app.services.crypto import normalize_email
from app.services.events import log_event
from app.services.pdf import render_report_pdf
from app.services.reports import domain_names
from app.web import is_htmx, render

router = APIRouter()
READY = ("ready", "fallback")
FAKE_DOOR_SOURCE = "sub_fakedoor"


def _report_or_404(db: Db, token: str) -> Report:
    report = db.scalar(select(Report).where(Report.token == token))
    if report is None:
        raise HTTPException(404)
    return report


def _result(db: Db, report: Report) -> Result:
    return db.get(Result, db.get(Order, report.order_id).session_id)


# PDF объявлен раньше: иначе «abc.pdf» попал бы в /report/{token}.
@router.get("/report/{token}.pdf")
def report_pdf(token: str, request: Request, db: Db) -> Response:
    report = _report_or_404(db, token)
    if report.status not in READY:
        raise HTTPException(404)
    q = request.app.state.questionnaire
    result = _result(db, report)
    archetype = next(e for e in q.scoring.archetype.table if e.id == result.archetype_id)
    pdf = render_report_pdf(
        report.content_json,
        request.app.state.app_config.site_name,
        result.happiness_index,
        archetype.name,
        domain_names(q),
    )
    headers = {
        "Content-Disposition": 'attachment; filename="indeks-schastya-otchet.pdf"',
        "Cache-Control": "private, no-store",
    }
    return Response(pdf, media_type="application/pdf", headers=headers)


@router.get("/report/{token}", response_class=HTMLResponse)
def report_page(token: str, request: Request, db: Db):
    report = _report_or_404(db, token)
    q = request.app.state.questionnaire
    result = _result(db, report)
    if report.status in READY:
        session = db.get(Session, result.session_id)
        log_event(db, session, "report_view", status=report.status)
    archetype = next(e for e in q.scoring.archetype.table if e.id == result.archetype_id)
    return render(
        request,
        "report.html",
        {
            "report": report,
            "content": report.content_json,
            "result": result,
            "archetype_name": archetype.name,
            "domain_names": domain_names(q),
        },
    )


# --- Фейковая дверь «Трекер счастья» (SPEC §3.6) -------------------------------------------------
# События пишутся в сессию покупателя через токен отчёта: отчёт часто открывают по ссылке из письма
# на другом устройстве, где cookie покупателя нет.


def _buyer_session(db: Db, report: Report) -> Session:
    result = _result(db, report)
    if result.screening_flag:  # защитный контур: таким людям не продаём и не собираем email
        raise HTTPException(404)
    return db.get(Session, result.session_id)


def _tracker(request: Request, state: str, report: Report, status: int = 200, **context):
    context = {"state": state, "report": report, **context}
    if is_htmx(request):
        return render(request, "_tracker.html", context, status)
    return render(request, "tracker_page.html", context, status)


@router.post("/report/{token}/tracker", response_class=HTMLResponse)
def tracker_click(token: str, request: Request, db: Db):
    report = _report_or_404(db, token)
    log_event(db, _buyer_session(db, report), "sub_fakedoor_click")
    return _tracker(request, "form", report)


@router.post("/lead", response_class=HTMLResponse)
async def lead(request: Request, db: Db):
    form = await request.form()
    report = _report_or_404(db, str(form.get("token", "")))
    session = _buyer_session(db, report)
    raw_email = str(form.get("email", ""))
    email = normalize_email(raw_email)
    if email is None:
        return _tracker(request, "form", report, error="Проверь email", email=raw_email, status=422)
    if form.get("agree") != "yes":
        error = "Отметь согласие, чтобы мы могли написать"
        return _tracker(request, "form", report, error=error, email=raw_email, status=422)
    cipher = request.app.state.email_cipher
    db.add(
        Lead(
            email_encrypted=cipher.encrypt(email),
            email_hash=cipher.hash(email),
            source=FAKE_DOOR_SOURCE,
            session_id=session.id,
            consent_at=datetime.now(UTC),
        )
    )
    try:
        db.commit()
    except IntegrityError:  # этот email уже оставлен — второй строки и события не будет
        db.rollback()
    else:
        log_event(db, session, "sub_email_submit")
    return _tracker(request, "thanks", report)
