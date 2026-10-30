"""Пейволл → заказ → ЮKassa → вебхук. SPEC §3.5, §7."""

import logging
from decimal import Decimal

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import HTMLResponse
from sqlalchemy import select

from app.db.models import Order, Report
from app.db.session import Db
from app.routes.results import result_context
from app.services.crypto import normalize_email
from app.services.orders import (
    apply_payment,
    latest_order,
    paid_order,
    start_checkout,
    sync_order,
)
from app.services.payments import MockGateway, PaymentError, webhook_ip_allowed
from app.services.results import result_of
from app.services.sessions import get_session
from app.web import is_htmx, redirect, render

log = logging.getLogger(__name__)
router = APIRouter()


def _on_paid(request: Request):
    return request.app.state.report_service.on_paid


def _paywall_error(request: Request, db: Db, result, session, error: str, email: str, status: int):
    context = result_context(request, db, result, session) | {
        "paywall_error": error,
        "paywall_email": email,
    }
    template = "_paywall.html" if is_htmx(request) else "result.html"
    return render(request, template, context, status)


@router.post("/checkout")
async def checkout(request: Request, db: Db):
    session = get_session(db, request, request.app.state.settings)
    result = result_of(db, session) if session and session.consent_at else None
    if session is None or result is None:
        return redirect(request, "/test")
    # Защитный контур: человеку с флагом скрининга не продаём ни при каком запросе.
    if result.screening_flag:
        raise HTTPException(403)
    if paid_order(db, session):
        return redirect(request, "/checkout/return")

    form = await request.form()
    raw_email = str(form.get("email", ""))
    email = normalize_email(raw_email)
    if email is None:
        return _paywall_error(request, db, result, session, "Проверь email", raw_email, 422)
    if form.get("agree_offer") != "yes":
        error = "Чтобы продолжить, прими условия оферты"
        return _paywall_error(request, db, result, session, error, raw_email, 422)

    base_url = request.app.state.settings.app_base_url.rstrip("/")
    try:
        url = start_checkout(
            db,
            request.app.state.payment_gateway,
            request.app.state.email_cipher,
            request.app.state.app_config,
            session,
            email,
            f"{base_url}/checkout/return",
        )
    except PaymentError:
        error = "Не получилось перейти к оплате. Попробуй ещё раз через минуту."
        return _paywall_error(request, db, result, session, error, raw_email, 503)
    return redirect(request, url)


@router.get("/checkout/return", response_class=HTMLResponse)
def checkout_return(request: Request, db: Db):
    """Сюда ЮKassa возвращает человека после оплаты. Статус перепроверяем у API."""
    session = get_session(db, request, request.app.state.settings)
    order = latest_order(db, session) if session else None
    if order is None:
        return redirect(request, "/")
    if order.status == "pending":
        sync_order(db, request.app.state.payment_gateway, order, _on_paid(request))
    report = db.get(Report, order.id) if order.status == "succeeded" else None
    if report is not None:
        return redirect(request, f"/report/{report.token}")
    result = result_of(db, session)
    return render(
        request,
        "checkout_return.html",
        {"order": order, "result_url": f"/r/{result.public_id}" if result else "/"},
    )


@router.post("/webhooks/yookassa")
async def yookassa_webhook(request: Request, db: Db) -> Response:
    gateway = request.app.state.payment_gateway
    if not gateway.is_mock and not webhook_ip_allowed(request.client and request.client.host):
        raise HTTPException(403)
    try:
        payload = await request.json()
        event, obj = payload["event"], payload["object"]
        payment_id = obj["payment_id"] if event.startswith("refund.") else obj["id"]
    except (ValueError, KeyError, TypeError, AttributeError):
        raise HTTPException(400) from None
    # Из тела берём только id платежа. Статус и сумму узнаём у API — телу не доверяем.
    order = db.scalar(select(Order).where(Order.yookassa_payment_id == str(payment_id)))
    if order is None:
        log.warning("вебхук %s: неизвестный платёж", event)
        return Response(status_code=200)
    try:
        info = gateway.get_payment(order.yookassa_payment_id)
    except PaymentError:
        raise HTTPException(503) from None  # ЮKassa повторит вебхук
    apply_payment(db, order, info, _on_paid(request))
    return Response(status_code=200)


# --- Мок ЮKassa для разработки (только пока нет ключей и не в production) ------------------------


def _mock(request: Request) -> MockGateway:
    gateway = request.app.state.payment_gateway
    if not isinstance(gateway, MockGateway) or request.app.state.settings.is_production:
        raise HTTPException(404)
    return gateway


@router.get("/dev/yookassa/{payment_id}", response_class=HTMLResponse)
def mock_payment_page(payment_id: str, request: Request):
    payment = _mock(request).payments.get(payment_id) or None
    if payment is None:
        raise HTTPException(404)
    return render(request, "dev_mock_payment.html", {"payment": payment})


@router.post("/dev/yookassa/{payment_id}")
async def mock_payment_action(payment_id: str, request: Request, db: Db):
    gateway = _mock(request)
    if payment_id not in gateway.payments:
        raise HTTPException(404)
    action = (await request.form()).get("action")
    payment = gateway.payments[payment_id]
    if action == "pay":
        gateway.set_status(payment_id, "succeeded")
    elif action == "cancel":
        gateway.set_status(payment_id, "canceled")
    elif action == "refund":
        gateway.set_status(payment_id, payment.status, refunded=Decimal(payment.amount))
    else:
        raise HTTPException(400)
    # Как настоящая ЮKassa: уведомление на вебхук (через тот же код), затем возврат на сайт.
    order = db.scalar(select(Order).where(Order.yookassa_payment_id == payment_id))
    if order is not None:
        sync_order(db, gateway, order, _on_paid(request))
    return redirect(request, "/checkout/return")
