"""Дашборд воронки /admin (basic auth) и выгрузка CSV. docs/ANALYTICS.md."""

import csv
import io
import secrets
from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse, Response
from fastapi.security import HTTPBasic, HTTPBasicCredentials

from app.db.session import Db
from app.services.admin_metrics import (
    Filters,
    build_dashboard,
    lead_count,
    load_facts,
    report_counts,
    utm_sources,
)
from app.web import render

security = HTTPBasic(realm="admin")


def require_admin(
    request: Request, credentials: Annotated[HTTPBasicCredentials, Depends(security)]
) -> None:
    settings = request.app.state.settings
    user_ok = secrets.compare_digest(credentials.username.encode(), settings.admin_user.encode())
    password_ok = secrets.compare_digest(
        credentials.password.encode(), settings.admin_password.encode()
    )
    if not (user_ok and password_ok):
        raise HTTPException(401, headers={"WWW-Authenticate": 'Basic realm="admin"'})


router = APIRouter(dependencies=[Depends(require_admin)])


def _date(value: str | None) -> date | None:
    try:
        return date.fromisoformat(value) if value else None
    except ValueError:
        raise HTTPException(400, "Дата в формате ГГГГ-ММ-ДД") from None


def _filters(request: Request) -> Filters:
    params = request.query_params
    price = params.get("price")
    if price and not price.isdigit():
        raise HTTPException(400, "Цена — число")
    return Filters(
        date_from=_date(params.get("from")),
        date_to=_date(params.get("to")),
        utm_source=params.get("utm_source") or None,
        price=int(price) if price else None,
        include_internal=params.get("internal") == "1",
        timezone=request.app.state.app_config.metrics.timezone,
    )


def _dashboard(request: Request, db: Db, f: Filters):
    return build_dashboard(
        load_facts(db, f),
        request.app.state.app_config,
        request.app.state.questionnaire,
        report_counts(db, f),
        lead_count(db, f),
    )


@router.get("/admin", response_class=HTMLResponse)
def admin(request: Request, db: Db):
    f = _filters(request)
    return render(
        request,
        "admin.html",
        {
            "f": f,
            "dash": _dashboard(request, db, f),
            "utm_options": utm_sources(db),
            "prices": request.app.state.app_config.pricing.ab_variants_rub,
            "query": request.url.query,
        },
    )


@router.get("/admin/export/{slug}.csv")
def export_csv(slug: str, request: Request, db: Db) -> Response:
    dash = _dashboard(request, db, _filters(request))
    if slug == "metrics":
        headers = ["метрика", "формула", "k", "n", "значение", "ci_low", "ci_high", "цвет"]
        rows = [
            [name, formula, p.k, p.n, p.value, p.low, p.high, p.color]
            for name, formula, p in dash.metrics
        ]
    elif table := dash.table(slug):
        headers, rows = table.headers, table.rows
    else:
        raise HTTPException(404)
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(headers)
    writer.writerows(rows)
    return Response(
        "﻿" + buf.getvalue(),  # BOM — чтобы Excel открыл кириллицу
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{slug}.csv"'},
    )
