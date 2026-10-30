"""Платный отчёт по секретной ссылке: /report/{token} и PDF. SPEC §3.6."""

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, Response
from sqlalchemy import select

from app.db.models import Order, Report, Result, Session
from app.db.session import Db
from app.services.events import log_event
from app.services.pdf import render_report_pdf
from app.services.reports import domain_names
from app.web import render

router = APIRouter()
READY = ("ready", "fallback")


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
