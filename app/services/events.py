"""События воронки (docs/ANALYTICS.md) в серверную таблицу events.

Props — только из белого списка ключей: никаких ПДн и никаких ответов теста.
"""

from typing import Any

from sqlalchemy import exists, select
from sqlalchemy.orm import Session as DbSession

from app.db.models import Event, Session

PROP_MAX_LEN = 255

# Событие → допустимые ключи props.
EVENTS: dict[str, frozenset[str]] = {
    "landing_view": frozenset({"utm_source", "utm_medium", "utm_campaign", "ref"}),
    "consent_given": frozenset({"version"}),
    "test_start": frozenset(),
    "question_answered": frozenset({"index", "block"}),
    "test_complete": frozenset({"archetype_id"}),
    "result_view": frozenset({"mode"}),
    "share_click": frozenset({"channel"}),
    "paywall_view": frozenset({"price"}),
    "checkout_start": frozenset({"price"}),
    "payment_success": frozenset({"price"}),
    "payment_refund": frozenset({"price"}),
    "report_view": frozenset({"status"}),
    "sub_fakedoor_click": frozenset(),
    "sub_email_submit": frozenset(),
}

SHARE_CHANNELS = frozenset({"vk", "tg", "copy", "card"})


def _clean(name: str, props: dict[str, Any]) -> dict[str, Any]:
    allowed = EVENTS[name]
    if unknown := set(props) - allowed:
        raise ValueError(f"{name}: недопустимые props {sorted(unknown)}")
    return {
        k: v[:PROP_MAX_LEN] if isinstance(v, str) else v for k, v in props.items() if v is not None
    }


def log_event(db: DbSession, session: Session, name: str, **props: Any) -> None:
    db.add(Event(session_id=session.id, name=name, props=_clean(name, props)))
    db.commit()


def log_event_once(db: DbSession, session: Session, name: str, **props: Any) -> None:
    """Для событий-шагов воронки (test_start): повторный показ не раздувает знаменатель."""
    already = db.scalar(select(exists().where(Event.session_id == session.id, Event.name == name)))
    if not already:
        log_event(db, session, name, **props)


# События, которые может прислать браузер, и проверка их props. Остальные пишет только сервер.
def validate_client_event(name: object, props: object) -> dict[str, str]:
    if not isinstance(props, dict):
        raise ValueError("props должен быть объектом")
    if name == "share_click" and set(props) == {"channel"} and props["channel"] in SHARE_CHANNELS:
        return {"channel": props["channel"]}
    if name == "paywall_view" and props == {}:
        return {}  # цену подставляет сервер из сессии — клиенту не доверяем
    raise ValueError("недопустимое событие")
