"""Метрики MVP для /admin (SPEC §1, docs/ANALYTICS.md).

Всё считается по уникальным сессиям из серверных событий. Период — по дате создания сессии
(когорта). Внутренние сессии (dev, мок-оплаты, cookie internal=1) по умолчанию исключены.
"""

import math
import uuid
from collections import Counter
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta
from typing import Any

from sqlalchemy import Select, func, select
from sqlalchemy.orm import Session as DbSession

from app.config import AppConfig, Questionnaire, Threshold
from app.db.models import Event, Lead, Order, Report, Result, Session

NO_UTM = "(нет)"
FUNNEL = (
    "landing_view",
    "test_start",
    "test_complete",
    "paywall_view",
    "checkout_start",
    "payment_success",
)


@dataclass(frozen=True)
class Filters:
    date_from: date | None = None
    date_to: date | None = None  # включительно
    utm_source: str | None = None  # NO_UTM — сессии без utm_source
    price: int | None = None
    include_internal: bool = False


@dataclass
class SessionFacts:
    id: uuid.UUID
    utm_source: str | None
    price: int | None
    has_ref: bool
    events: set[str] = field(default_factory=set)
    share_channels: set[str] = field(default_factory=set)
    max_question: int = 0
    flagged: bool | None = None  # None — теста нет
    archetype: str | None = None
    revenue: int = 0

    @property
    def started(self) -> bool:
        return "test_start" in self.events

    @property
    def completed(self) -> bool:
        return "test_complete" in self.events

    @property
    def paid(self) -> bool:
        return "payment_success" in self.events


# --- Загрузка ------------------------------------------------------------------------------------


def session_ids(f: Filters) -> Select:
    query = select(Session.id)
    if not f.include_internal:
        query = query.where(Session.is_internal.is_(False))
    if f.date_from:
        query = query.where(Session.created_at >= datetime.combine(f.date_from, time(), UTC))
    if f.date_to:
        end = datetime.combine(f.date_to + timedelta(days=1), time(), UTC)
        query = query.where(Session.created_at < end)
    if f.utm_source == NO_UTM:
        query = query.where(Session.utm_source.is_(None))
    elif f.utm_source:
        query = query.where(Session.utm_source == f.utm_source)
    if f.price is not None:
        query = query.where(Session.price_variant == f.price)
    return query


def load_facts(db: DbSession, f: Filters) -> list[SessionFacts]:
    ids = session_ids(f)
    facts = {
        sid: SessionFacts(sid, utm, price, ref is not None)
        for sid, utm, price, ref in db.execute(
            select(
                Session.id, Session.utm_source, Session.price_variant, Session.ref_public_id
            ).where(Session.id.in_(ids))
        )
    }
    for sid, name in db.execute(
        select(Event.session_id, Event.name).where(Event.session_id.in_(ids)).distinct()
    ):
        facts[sid].events.add(name)
    channel = Event.props["channel"].as_string()
    for sid, ch in db.execute(
        select(Event.session_id, channel)
        .where(Event.session_id.in_(ids), Event.name == "share_click")
        .distinct()
    ):
        facts[sid].share_channels.add(ch)
    index = Event.props["index"].as_integer()
    for sid, max_index in db.execute(
        select(Event.session_id, func.max(index))
        .where(Event.session_id.in_(ids), Event.name == "question_answered")
        .group_by(Event.session_id)
    ):
        facts[sid].max_question = max_index or 0
    for sid, flagged, archetype in db.execute(
        select(Result.session_id, Result.screening_flag, Result.archetype_id).where(
            Result.session_id.in_(ids)
        )
    ):
        facts[sid].flagged, facts[sid].archetype = flagged, archetype
    for sid, revenue in db.execute(
        select(Order.session_id, func.sum(Order.amount_rub))
        .where(Order.session_id.in_(ids), Order.status == "succeeded")
        .group_by(Order.session_id)
    ):
        facts[sid].revenue = int(revenue or 0)
    return list(facts.values())


def utm_sources(db: DbSession) -> list[str]:
    values = db.scalars(select(Session.utm_source).distinct().order_by(Session.utm_source))
    return [v if v is not None else NO_UTM for v in values]


# --- Доли и доверительные интервалы --------------------------------------------------------------


def wilson(k: int, n: int, z: float) -> tuple[float, float] | None:
    if n == 0:
        return None
    p = k / n
    denom = 1 + z * z / n
    center = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return max(0.0, center - half), min(1.0, center + half)


@dataclass(frozen=True)
class Proportion:
    k: int
    n: int
    low: float | None
    high: float | None
    color: str  # green | red | grey
    threshold: Threshold | None = None

    @property
    def value(self) -> float | None:
        return self.k / self.n if self.n else None


def proportion(k: int, n: int, z: float, threshold: Threshold | None = None) -> Proportion:
    interval = wilson(k, n, z)
    low, high = interval if interval else (None, None)
    color = "grey"
    if threshold and interval:
        if low > threshold.go:
            color = "green"
        elif threshold.stop is not None and high < threshold.stop:
            color = "red"
    return Proportion(k, n, low, high, color, threshold)


# --- Дашборд -------------------------------------------------------------------------------------


@dataclass
class Table:
    slug: str
    title: str
    headers: list[str]
    rows: list[list[Any]]


@dataclass
class Dashboard:
    metrics: list[tuple[str, str, Proportion]]  # (название, формула, доля)
    viral: tuple[int, int]
    flagged: tuple[int, int]
    tables: list[Table]

    def table(self, slug: str) -> Table | None:
        return next((t for t in self.tables if t.slug == slug), None)


def _pct(p: float | None) -> str:
    return "—" if p is None else f"{p * 100:.1f}%"


def _ci(p: Proportion) -> str:
    return "—" if p.low is None else f"{_pct(p.low)}–{_pct(p.high)}"


def build_dashboard(
    facts: list[SessionFacts],
    app_config: AppConfig,
    q: Questionnaire,
    reports: dict[str, int],
    leads: int,
) -> Dashboard:
    m = app_config.metrics
    z = m.ci_z
    started = [s for s in facts if s.started]
    completed = [s for s in facts if s.completed]
    eligible = [s for s in completed if not s.flagged]  # без флага скрининга
    paid = [s for s in facts if s.paid]

    metrics = [
        (
            "Дохождение",
            "test_complete / test_start",
            proportion(sum(s.completed for s in started), len(started), z, m.completion),
        ),
        (
            "Шеринг",
            "share_click / test_complete",
            proportion(
                sum("share_click" in s.events for s in completed), len(completed), z, m.share
            ),
        ),
        (
            "Конверсия в покупку",
            "payment_success / test_complete без флага",
            proportion(sum(s.paid for s in eligible), len(eligible), z, m.conversion),
        ),
        (
            "Интерес к подписке",
            "sub_fakedoor_click / payment_success",
            proportion(
                sum("sub_fakedoor_click" in s.events for s in paid),
                len(paid),
                z,
                m.subscription_interest,
            ),
        ),
    ]
    viral = (sum(s.has_ref for s in started), len(completed))
    flagged = (sum(bool(s.flagged) for s in completed), len(completed))

    tables = [
        _funnel(facts),
        _dropoff(started, q),
        _share(completed, viral),
        _by_price(eligible, z, m.conversion),
        _by_utm(facts, z),
        _fake_door(paid, facts, leads, z, m.subscription_interest),
        _archetypes(completed, q),
        _reports(reports),
    ]
    return Dashboard(metrics, viral, flagged, tables)


def _funnel(facts: list[SessionFacts]) -> Table:
    counts = [sum(step in s.events for s in facts) for step in FUNNEL]
    rows = []
    for i, (step, count) in enumerate(zip(FUNNEL, counts, strict=True)):
        prev = counts[i - 1] if i else None
        rows.append(
            [
                step,
                count,
                _pct(count / prev) if prev else "—",
                _pct(count / counts[0]) if counts[0] else "—",
            ]
        )
    return Table(
        "funnel",
        "Воронка (уникальные сессии)",
        ["шаг", "сессий", "от предыдущего", "от первого"],
        rows,
    )


def _dropoff(started: list[SessionFacts], q: Questionnaire) -> Table:
    items = [(b.title, i.id) for b in q.blocks for i in b.items]
    rows = []
    for k, (block, item_id) in enumerate(items, 1):
        reached = sum(s.max_question >= k for s in started)
        stopped = sum(s.max_question == k and not s.completed for s in started)
        rows.append(
            [k, item_id, block, reached, _pct(reached / len(started)) if started else "—", stopped]
        )
    return Table(
        "dropoff",
        "Где бросают тест (по номеру вопроса)",
        ["№", "вопрос", "блок", "ответили", "от начавших", "остановились на нём"],
        rows,
    )


def _share(completed: list[SessionFacts], viral: tuple[int, int]) -> Table:
    channels = Counter(ch for s in completed for ch in s.share_channels)
    rows = [
        [ch, channels.get(ch, 0), _pct(channels.get(ch, 0) / len(completed)) if completed else "—"]
        for ch in ("vk", "tg", "copy", "card")
    ]
    rows.append(
        [
            "вирусный коэффициент (test_start с ref / test_complete)",
            f"{viral[0]} / {viral[1]}",
            f"{viral[0] / viral[1]:.2f}" if viral[1] else "—",
        ]
    )
    return Table("share", "Шеринг по каналам", ["канал", "сессий", "от прошедших"], rows)


def _by_price(eligible: list[SessionFacts], z: float, threshold: Threshold) -> Table:
    rows = []
    for price in sorted({s.price for s in eligible}, key=lambda p: (p is None, p)):
        group = [s for s in eligible if s.price == price]
        payers = sum(s.paid for s in group)
        revenue = sum(s.revenue for s in group)
        p = proportion(payers, len(group), z, threshold)
        rows.append(
            [
                price if price is not None else "не назначена",
                len(group),
                payers,
                _pct(p.value),
                _ci(p),
                revenue,
                f"{revenue / len(group):.1f}",
            ]
        )
    return Table(
        "price",
        "Конверсия и выручка по A/B-цене (прошедшие без флага скрининга)",
        [
            "цена, ₽",
            "прошли тест",
            "оплатили",
            "конверсия",
            "95% CI",
            "выручка, ₽",
            "выручка на прошедшего, ₽",
        ],
        rows,
    )


def _by_utm(facts: list[SessionFacts], z: float) -> Table:
    rows = []
    for utm in sorted({s.utm_source or NO_UTM for s in facts}):
        group = [s for s in facts if (s.utm_source or NO_UTM) == utm]
        started = [s for s in group if s.started]
        completed = [s for s in group if s.completed]
        eligible = [s for s in completed if not s.flagged]
        completion = proportion(len([s for s in started if s.completed]), len(started), z)
        conversion = proportion(sum(s.paid for s in eligible), len(eligible), z)
        rows.append(
            [
                utm,
                len(group),
                len(started),
                len(completed),
                _pct(completion.value),
                _pct(sum("share_click" in s.events for s in completed) / len(completed))
                if completed
                else "—",
                sum(s.paid for s in group),
                _pct(conversion.value),
                _ci(conversion),
            ]
        )
    return Table(
        "utm",
        "Разбивка по utm_source",
        [
            "utm_source",
            "сессий",
            "начали тест",
            "прошли",
            "дохождение",
            "шеринг",
            "оплатили",
            "конверсия",
            "95% CI конверсии",
        ],
        rows,
    )


def _fake_door(paid, facts, leads: int, z: float, threshold: Threshold) -> Table:
    clicks = sum("sub_fakedoor_click" in s.events for s in facts)
    emails = sum("sub_email_submit" in s.events for s in facts)
    p = proportion(sum("sub_fakedoor_click" in s.events for s in paid), len(paid), z, threshold)
    rows = [
        ["клик «Хочу» (сессий)", clicks],
        ["оставили email (сессий)", emails],
        ["лидов в таблице leads", leads],
        ["клик / оплатившие", f"{_pct(p.value)} (CI {_ci(p)}, n={p.n})"],
    ]
    return Table("fakedoor", "Фейковая дверь «Трекер счастья»", ["показатель", "значение"], rows)


def _archetypes(completed: list[SessionFacts], q: Questionnaire) -> Table:
    counts = Counter(s.archetype for s in completed if s.archetype)
    total = sum(counts.values())
    rows = [
        [e.id, e.name, counts.get(e.id, 0), _pct(counts.get(e.id, 0) / total) if total else "—"]
        for e in q.scoring.archetype.table
    ]
    return Table(
        "archetypes",
        "Распределение архетипов (перекос → пересмотреть порог)",
        ["id", "архетип", "результатов", "доля"],
        rows,
    )


def _reports(reports: dict[str, int]) -> Table:
    rows = [
        ["всего отчётов", reports.get("total", 0)],
        ["готово через LLM с первого раза", reports.get("ready_first", 0)],
        ["fallback-отчётов всего", reports.get("fallback_ever", 0)],
        ["из них перегенерировано", reports.get("regenerated", 0)],
        ["ещё на fallback", reports.get("fallback", 0)],
        ["failed", reports.get("failed", 0)],
        ["в генерации", reports.get("pending", 0)],
    ]
    return Table("reports", "Отчёты", ["показатель", "значение"], rows)


def report_counts(db: DbSession, f: Filters) -> dict[str, int]:
    ids = session_ids(f)
    rows = db.execute(
        select(Report.status, Report.regenerated_at.is_not(None), func.count())
        .join(Order, Order.id == Report.order_id)
        .where(Order.session_id.in_(ids))
        .group_by(Report.status, Report.regenerated_at.is_not(None))
    )
    counts: Counter[str] = Counter()
    for status, regenerated, n in rows:
        counts["total"] += n
        counts[status] += n
        if regenerated:
            counts["regenerated"] += n
        elif status == "ready":
            counts["ready_first"] += n
    counts["fallback_ever"] = counts["fallback"] + counts["regenerated"]
    return dict(counts)


def lead_count(db: DbSession, f: Filters) -> int:
    return db.scalar(select(func.count()).where(Lead.session_id.in_(session_ids(f)))) or 0
