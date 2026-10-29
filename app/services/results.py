"""Запись результата и данные для страницы результата."""

import secrets
from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session as DbSession

from app.config import AppConfig, Questionnaire
from app.db.models import Answer, Result, Session
from app.scoring import ScoringResult, score
from app.services.events import log_event

PUBLIC_ID_BYTES = 9  # 12 символов base64url


def stored_answers(db: DbSession, session: Session) -> dict[str, str]:
    rows = db.execute(select(Answer.item_id, Answer.value).where(Answer.session_id == session.id))
    return {item_id: value for item_id, value in rows}


def result_of(db: DbSession, session: Session) -> Result | None:
    return db.get(Result, session.id)


def save_answer(db: DbSession, session: Session, item_id: str, value: str) -> None:
    """Upsert: при «назад» ответ перезаписывается."""
    answer = db.get(Answer, (session.id, item_id))
    if answer is None:
        db.add(Answer(session_id=session.id, item_id=item_id, value=value))
    else:
        answer.value = value
        answer.answered_at = func.now()
    db.commit()


def complete(db: DbSession, q: Questionnaire, session: Session, carried: dict[str, str]) -> Result:
    """Подсчёт и запись результата. Ответы скрининга (`carried`) используются только здесь
    и в БД не попадают — сохраняется лишь флаг. Бросает ScoringError при неполных ответах."""
    scored: ScoringResult = score(q, stored_answers(db, session) | carried)
    result = Result(
        session_id=session.id,
        public_id=secrets.token_urlsafe(PUBLIC_ID_BYTES),
        swls_raw=scored.swls_raw,
        happiness_index=scored.happiness_index,
        trait_e=scored.traits["E"],
        trait_a=scored.traits["A"],
        trait_c=scored.traits["C"],
        trait_n=scored.traits["N"],
        trait_o=scored.traits["O"],
        archetype_id=scored.archetype_id,
        domain_scores=scored.domain_scores,
        leaks=scored.leaks,
        vciom_answer=scored.vciom_answer,
        screening_flag=scored.screening_flag,
    )
    db.add(result)
    try:
        db.commit()
    except IntegrityError:  # двойная отправка: результат уже записан
        db.rollback()
        existing = result_of(db, session)
        if existing is None:  # pragma: no cover — коллизия public_id, практически невозможна
            raise
        return existing
    log_event(db, session, "test_complete", archetype_id=result.archetype_id)
    return result


def percentile(db: DbSession, result: Result, min_completed: int) -> int | None:
    """«Выше, чем у N% участников»; None, пока завершённых тестов меньше порога."""
    total = db.scalar(select(func.count()).select_from(Result)) or 0
    if total < min_completed or total == 0:
        return None
    below = db.scalar(select(func.count()).where(Result.happiness_index < result.happiness_index))
    return (200 * (below or 0) + total) // (2 * total)


@dataclass(frozen=True)
class VciomLine:
    text: str
    source_name: str
    source_url: str
    period: str


ONE_IN_WORDS = {
    2: "каждый второй",
    3: "каждый третий",
    4: "каждый четвёртый",
    5: "каждый пятый",
    6: "каждый шестой",
    7: "каждый седьмой",
    8: "каждый восьмой",
    9: "каждый девятый",
    10: "каждый десятый",
}


def one_in(share: float) -> str:
    """Доля словами: 0.22 → «каждый пятый»; вне 1/2…1/10 — процентом."""
    if share > 0 and (n := int(1 / share + 0.5)) in ONE_IN_WORDS:
        return ONE_IN_WORDS[n]
    return f"{_pct(share)}% россиян"


def vciom_line(app_config: AppConfig, answer_id: str) -> VciomLine:
    """Строка про ответ на вопрос ВЦИОМ (тексты — config/app.yaml). Личный индекс 0–100 здесь
    не участвует: индекс ВЦИОМ — другая метрика."""
    country = app_config.country_index
    text = app_config.vciom_result_texts[answer_id].format(
        happy=_pct(country.share_happy),
        unhappy=_pct(country.share_unhappy),
        hard_to_say=_pct(country.share_hard_to_say),
        unhappy_one_in=one_in(country.share_unhappy),
    )
    return VciomLine(text, country.source_name, country.source_url, country.period)


def _pct(share: float) -> int:
    return int(share * 100 + 0.5)
