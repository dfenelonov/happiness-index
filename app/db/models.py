"""Модели данных по docs/SPEC.md §6."""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base, JsonType

REPORT_STATUSES = ("pending", "ready", "fallback", "failed")


def _created_at() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


class Session(Base):
    __tablename__ = "sessions"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    sid_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    created_at: Mapped[datetime] = _created_at()
    utm_source: Mapped[str | None] = mapped_column(String(255))
    utm_medium: Mapped[str | None] = mapped_column(String(255))
    utm_campaign: Mapped[str | None] = mapped_column(String(255))
    ref_public_id: Mapped[str | None] = mapped_column(String(32))
    # Варианты цены берутся из config/app.yaml, поэтому без CHECK на конкретные значения.
    price_variant: Mapped[int | None] = mapped_column(Integer)
    consent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    consent_version: Mapped[str | None] = mapped_column(String(32))


class Answer(Base):
    """Последний ответ на вопрос: при «назад» строка перезаписывается (upsert).

    Ответы блока скрининга сюда не пишутся никогда (store_answers: false).
    """

    __tablename__ = "answers"

    session_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("sessions.id", ondelete="CASCADE"), primary_key=True
    )
    item_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    # Строка: числовые шкалы хранят число, шкала ВЦИОМ — id варианта ответа.
    value: Mapped[str] = mapped_column(String(32), nullable=False)
    answered_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class Result(Base):
    __tablename__ = "results"

    session_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("sessions.id", ondelete="CASCADE"), primary_key=True
    )
    public_id: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    swls_raw: Mapped[int] = mapped_column(Integer, nullable=False)
    happiness_index: Mapped[int] = mapped_column(Integer, nullable=False)
    trait_e: Mapped[float] = mapped_column(Float, nullable=False)
    trait_a: Mapped[float] = mapped_column(Float, nullable=False)
    trait_c: Mapped[float] = mapped_column(Float, nullable=False)
    trait_n: Mapped[float] = mapped_column(Float, nullable=False)
    trait_o: Mapped[float] = mapped_column(Float, nullable=False)
    archetype_id: Mapped[str] = mapped_column(String(64), nullable=False)
    domain_scores: Mapped[dict[str, float]] = mapped_column(JsonType, nullable=False)
    leaks: Mapped[list[str]] = mapped_column(JsonType, nullable=False)
    vciom_answer: Mapped[str] = mapped_column(String(32), nullable=False)
    screening_flag: Mapped[bool] = mapped_column(Boolean, nullable=False)
    completed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class Order(Base):
    __tablename__ = "orders"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    session_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("sessions.id"), nullable=False)
    amount_rub: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    yookassa_payment_id: Mapped[str | None] = mapped_column(String(64), unique=True)
    email_encrypted: Mapped[str] = mapped_column(Text, nullable=False)  # Fernet-токен
    email_hash: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    created_at: Mapped[datetime] = _created_at()
    paid_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    refunded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Report(Base):
    __tablename__ = "reports"
    __table_args__ = (CheckConstraint(f"status IN {REPORT_STATUSES}", name="status"),)

    # PK по order_id — один отчёт на заказ, повтор вебхука не создаст второй.
    order_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("orders.id"), primary_key=True)
    token: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")
    content_json: Mapped[dict[str, Any] | None] = mapped_column(JsonType)
    provider: Mapped[str | None] = mapped_column(String(32))
    model: Mapped[str | None] = mapped_column(String(64))
    tokens_in: Mapped[int | None] = mapped_column(Integer)
    tokens_out: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = _created_at()


class Lead(Base):
    __tablename__ = "leads"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    email_encrypted: Mapped[str] = mapped_column(Text, nullable=False)  # Fernet-токен
    email_hash: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    source: Mapped[str] = mapped_column(String(32), nullable=False)
    session_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("sessions.id"))
    consent_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class Event(Base):
    __tablename__ = "events"
    __table_args__ = (Index("ix_events_name_created_at", "name", "created_at"),)

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True
    )
    session_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("sessions.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    props: Mapped[dict[str, Any]] = mapped_column(JsonType, nullable=False, default=dict)
    created_at: Mapped[datetime] = _created_at()
