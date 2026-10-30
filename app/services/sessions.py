"""Анонимная сессия по cookie `sid`: в БД хранится только HMAC от sid."""

import hashlib
import hmac
import re
import secrets
from datetime import UTC, datetime

from fastapi import Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from app.config import Settings
from app.db.models import Session

SID_COOKIE = "sid"
SID_MAX_AGE = 90 * 24 * 3600
INTERNAL_COOKIE = "internal"
INTERNAL_MAX_AGE = 365 * 24 * 3600
UTM_KEYS = ("utm_source", "utm_medium", "utm_campaign")
UTM_MAX_LEN = 255
REF_PATTERN = re.compile(r"^[A-Za-z0-9_-]{6,32}$")


def hash_sid(sid: str, secret_key: str) -> str:
    return hmac.new(secret_key.encode(), sid.encode(), hashlib.sha256).hexdigest()


def get_session(db: DbSession, request: Request, settings: Settings) -> Session | None:
    sid = request.cookies.get(SID_COOKIE)
    if not sid:
        return None
    return db.scalar(select(Session).where(Session.sid_hash == hash_sid(sid, settings.secret_key)))


def _attribution(request: Request) -> dict[str, str | None]:
    params = request.query_params
    values: dict[str, str | None] = {
        k: (params.get(k) or "")[:UTM_MAX_LEN] or None for k in UTM_KEYS
    }
    ref = params.get("ref")
    values["ref_public_id"] = ref if ref and REF_PATTERN.fullmatch(ref) else None
    return values


def ensure_session(
    db: DbSession, request: Request, settings: Settings
) -> tuple[Session, str | None]:
    """Текущая сессия или новая с UTM/ref из URL (первое касание). Второе значение — новый sid,
    который нужно выставить в cookie через `set_sid_cookie`."""
    internal = is_internal_request(request, settings)
    if session := get_session(db, request, settings):
        if internal and not session.is_internal:
            mark_internal(db, session)
        return session, None
    sid = secrets.token_urlsafe(32)
    session = Session(
        sid_hash=hash_sid(sid, settings.secret_key), is_internal=internal, **_attribution(request)
    )
    db.add(session)
    db.commit()
    return session, sid


def is_internal_request(request: Request, settings: Settings) -> bool:
    """Внутренний трафик: любое окружение кроме production или cookie internal=1."""
    return not settings.is_production or request.cookies.get(INTERNAL_COOKIE) == "1"


def mark_internal(db: DbSession, session: Session) -> None:
    session.is_internal = True
    db.commit()


def set_internal_cookie(response: Response, settings: Settings) -> None:
    response.set_cookie(
        INTERNAL_COOKIE,
        "1",
        max_age=INTERNAL_MAX_AGE,
        httponly=True,
        secure=settings.is_production,
        samesite="lax",
    )


def set_sid_cookie(response: Response, sid: str | None, settings: Settings) -> None:
    if sid:
        response.set_cookie(
            SID_COOKIE,
            sid,
            max_age=SID_MAX_AGE,
            httponly=True,
            secure=settings.is_production,
            samesite="lax",
        )


def give_consent(db: DbSession, session: Session, version: str) -> None:
    session.consent_at = datetime.now(UTC)
    session.consent_version = version
    db.commit()
