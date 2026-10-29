"""Цена A/B, заказы и статусы оплаты.

Статус заказа меняется только по данным, полученным запросом к API шлюза (`apply_payment`),
и только атомарным условным UPDATE — повтор или параллельный вебхук не дублирует событие.
"""

import logging
from datetime import UTC, datetime
from decimal import Decimal

from sqlalchemy import select, update
from sqlalchemy.orm import Session as DbSession

from app.config import AppConfig
from app.db.models import Order, Session
from app.services.crypto import EmailCipher
from app.services.events import log_event
from app.services.payments import PaymentError, PaymentGateway, PaymentInfo, PaymentRequest

log = logging.getLogger(__name__)


def price_for(db: DbSession, session: Session, variants: list[int]) -> int:
    """Вариант цены по хешу sid, закрепляется за сессией при первом показе."""
    if session.price_variant is None:
        session.price_variant = variants[int(session.sid_hash[:16], 16) % len(variants)]
        db.commit()
    return session.price_variant


def paid_order(db: DbSession, session: Session) -> Order | None:
    return db.scalar(
        select(Order).where(Order.session_id == session.id, Order.status == "succeeded")
    )


def latest_order(db: DbSession, session: Session) -> Order | None:
    return db.scalar(
        select(Order)
        .where(Order.session_id == session.id)
        .order_by(Order.created_at.desc(), Order.id)
        .limit(1)
    )


def start_checkout(
    db: DbSession,
    gateway: PaymentGateway,
    cipher: EmailCipher,
    app_config: AppConfig,
    session: Session,
    email: str,
    return_url: str,
) -> str:
    """Создаёт заказ и платёж, возвращает URL оплаты. PaymentError — платёж не создан."""
    price = price_for(db, session, app_config.pricing.ab_variants_rub)
    order = Order(
        session_id=session.id,
        amount_rub=price,
        status="pending",
        email_encrypted=cipher.encrypt(email),
        email_hash=cipher.hash(email),
    )
    db.add(order)
    db.commit()
    request = PaymentRequest(
        order_id=str(order.id),
        amount_rub=price,
        description=app_config.payments.description,
        email=email,
        vat_code=app_config.payments.receipt.vat_code,
        return_url=return_url,
    )
    try:
        info = gateway.create_payment(request)
        if not info.confirmation_url:
            raise PaymentError("нет confirmation_url")
    except PaymentError:
        order.status = "canceled"
        db.commit()
        raise
    order.yookassa_payment_id = info.id
    db.commit()
    log_event(db, session, "checkout_start", price=price)
    return info.confirmation_url


def _transition(db: DbSession, order: Order, source: str, target: str, **values) -> bool:
    result = db.execute(
        update(Order)
        .where(Order.id == order.id, Order.status == source)
        .values(status=target, **values)
    )
    db.commit()
    return result.rowcount == 1


def apply_payment(db: DbSession, order: Order, info: PaymentInfo) -> None:
    """Применяет статус платежа, полученный из API. Чужой заказ или другая сумма — игнор."""
    if (
        info.order_id != str(order.id)
        or info.currency != "RUB"
        or info.amount != Decimal(order.amount_rub)
    ):
        log.error("платёж %s не совпадает с заказом %s по id/сумме — пропущен", info.id, order.id)
        return
    session = db.get(Session, order.session_id)
    now = datetime.now(UTC)
    if info.status == "succeeded" and _transition(db, order, "pending", "succeeded", paid_at=now):
        log_event(db, session, "payment_success", price=order.amount_rub)
    elif info.status == "canceled":
        _transition(db, order, "pending", "canceled")
    if info.refunded_amount >= info.amount and _transition(
        db, order, "succeeded", "refunded", refunded_at=now
    ):
        log_event(db, session, "payment_refund", price=order.amount_rub)
    db.refresh(order)


def sync_order(db: DbSession, gateway: PaymentGateway, order: Order) -> None:
    """Перепроверка статуса у шлюза (вебхук, страница возврата). Ошибки API — без изменений."""
    if not order.yookassa_payment_id:
        return
    try:
        info = gateway.get_payment(order.yookassa_payment_id)
    except PaymentError:
        log.warning("не удалось получить платёж %s", order.yookassa_payment_id)
        return
    apply_payment(db, order, info)
