import csv
import io
import uuid
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import update

from app.config import Threshold, load_configs
from app.db.models import Event, Lead, Order, Report, Session
from app.services.admin_metrics import (
    NO_UTM,
    Filters,
    SessionFacts,
    build_dashboard,
    load_facts,
    proportion,
    wilson,
)
from app.services.llm import LLMError, MockLLMProvider
from app.services.sessions import is_internal_request
from tests.conftest import REAL_CONFIG_DIR, build_app, make_settings
from tests.flow import Q, complete_test, db_rows

CFG = load_configs(REAL_CONFIG_DIR).app
AUTH = ("admin", "change-me")
EMAIL = "buyer@example.ru"


def make_external(app: FastAPI) -> None:
    """В dev все сессии внутренние — для проверки метрик делаем их «настоящими»."""
    with app.state.session_factory() as db:
        db.execute(update(Session).values(is_internal=False))
        db.commit()


def pay(client: TestClient, app: FastAPI, **kwargs) -> Order:
    complete_test(client, **kwargs)
    client.post("/checkout", data={"email": EMAIL, "agree_offer": "yes"})
    order = next(o for o in db_rows(app, Order) if o.status == "pending")
    app.state.payment_gateway.set_status(order.yookassa_payment_id, "succeeded")
    client.post(
        "/webhooks/yookassa",
        json={"event": "payment.succeeded", "object": {"id": order.yookassa_payment_id}},
    )
    return order


def report_token(app: FastAPI) -> str:
    return db_rows(app, Report)[-1].token


# --- Доверительный интервал и цвет ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("k", "n", "low", "high"),
    [
        (0, 10, 0.0, 0.2775),
        (5, 10, 0.2366, 0.7634),
        (10, 10, 0.7225, 1.0),
        (25, 1000, 0.0170, 0.0367),
    ],
)
def test_wilson_reference_values(k, n, low, high) -> None:
    lo, hi = wilson(k, n, 1.96)
    assert (lo, hi) == (pytest.approx(low, abs=1e-4), pytest.approx(high, abs=1e-4))


def test_wilson_empty() -> None:
    assert wilson(0, 0, 1.96) is None
    assert proportion(0, 0, 1.96, Threshold(go=0.6, stop=0.45)).color == "grey"


@pytest.mark.parametrize(
    ("k", "n", "color"),
    [
        (700, 1000, "green"),  # CI ≈ 67–73% > 60%
        (300, 1000, "red"),  # CI ≈ 27–33% < 45%
        (55, 100, "grey"),  # CI пересекает пороги
        (7, 10, "grey"),  # 70%, но n мало — CI широкий
    ],
)
def test_threshold_colors(k, n, color) -> None:
    assert proportion(k, n, 1.96, CFG.metrics.completion).color == color


def test_no_stop_threshold_never_red() -> None:
    assert proportion(0, 1000, 1.96, CFG.metrics.subscription_interest).color == "grey"


# --- Расчёт дашборда на синтетических фактах -----------------------------------------------------


def facts(**kw) -> SessionFacts:
    events = kw.pop("events", set())
    return SessionFacts(
        id=uuid.uuid4(),
        utm_source=kw.pop("utm", "vk"),
        price=kw.pop("price", 690),
        has_ref=kw.pop("ref", False),
        events=set(events),
        **kw,
    )


FULL = {"landing_view", "test_start", "test_complete"}


def test_dashboard_formulas() -> None:
    sessions = [
        facts(events={"landing_view"}),
        facts(events={"landing_view", "test_start"}, max_question=4),
        facts(
            events=FULL | {"share_click"},
            share_channels={"tg"},
            max_question=26,
            archetype="pathfinder",
        ),
        facts(
            events=FULL
            | {"paywall_view", "checkout_start", "payment_success", "sub_fakedoor_click"},
            max_question=26,
            archetype="organizer",
            revenue=690,
            ref=True,
        ),
        facts(events=FULL, max_question=26, archetype="organizer"),
    ]
    dash = build_dashboard(sessions, CFG, Q, reports={}, leads=1)
    metrics = {name: (p.k, p.n) for name, _, p in dash.metrics}
    assert metrics == {
        "Дохождение": (3, 4),
        "Шеринг": (1, 3),
        "Конверсия в покупку": (1, 3),
        "Интерес к подписке": (1, 1),
    }
    assert dash.viral == (1, 3)
    funnel = {row[0]: row[1] for row in dash.table("funnel").rows}
    assert funnel == {
        "landing_view": 5,
        "test_start": 4,
        "test_complete": 3,
        "paywall_view": 1,
        "checkout_start": 1,
        "payment_success": 1,
    }
    dropoff = dash.table("dropoff").rows
    assert dropoff[3][3] == 4 and dropoff[3][5] == 1  # вопрос 4: ответили 4, один остановился
    assert dropoff[4][3] == 3
    [price_row] = dash.table("price").rows
    assert price_row[:3] == [690, 3, 1] and price_row[5] == 690
    archetypes = {row[0]: row[2] for row in dash.table("archetypes").rows}
    assert archetypes["organizer"] == 2 and archetypes["pathfinder"] == 1
    share = {row[0]: row[1] for row in dash.table("share").rows}
    assert share["tg"] == 1 and share["vk"] == 0


# --- Загрузка из БД и фильтры --------------------------------------------------------------------


def test_internal_sessions_excluded_by_default(client: TestClient, app: FastAPI) -> None:
    complete_test(client)
    with app.state.session_factory() as db:
        assert load_facts(db, Filters()) == []  # dev → все сессии внутренние
        assert len(load_facts(db, Filters(include_internal=True))) == 1
    make_external(app)
    with app.state.session_factory() as db:
        [f] = load_facts(db, Filters())
    assert f.completed and f.max_question == 26


def test_filters(app: FastAPI) -> None:
    with TestClient(app, follow_redirects=False) as vk:
        vk.get("/?utm_source=vk")
        complete_test(vk)
    with TestClient(app, follow_redirects=False) as direct:
        complete_test(direct)
    make_external(app)
    with app.state.session_factory() as db:
        price = db_rows(app, Session)[0].price_variant
        assert len(load_facts(db, Filters(utm_source="vk"))) == 1
        assert len(load_facts(db, Filters(utm_source=NO_UTM))) == 1
        assert len(load_facts(db, Filters(price=price))) >= 1
        today = datetime.now(ZoneInfo("Europe/Moscow")).date()  # даты фильтра — по Москве
        assert len(load_facts(db, Filters(date_from=today, date_to=today))) == 2
        assert load_facts(db, Filters(date_to=today - timedelta(days=1))) == []


# --- /admin: доступ, страница, CSV ---------------------------------------------------------------


@pytest.mark.parametrize("auth", [None, ("admin", "wrong"), ("other", "change-me")])
def test_admin_requires_auth(client: TestClient, auth) -> None:
    r = client.get("/admin", auth=auth)
    assert r.status_code == 401 and "Basic" in r.headers["www-authenticate"]
    assert client.get("/admin/export/funnel.csv", auth=auth).status_code == 401


def test_admin_page_and_toggle(client: TestClient, app: FastAPI) -> None:
    complete_test(client)
    html = client.get("/admin", auth=AUTH).text
    assert "Внутренние сессии (dev, мок-оплаты, cookie internal=1) исключены" in html
    assert 'data-metric="Дохождение" data-color="grey"' in html and "0/0" in html
    html = client.get("/admin?internal=1", auth=AUTH).text
    assert "Внутренние сессии включены" in html and "1/1" in html


def test_admin_csv_exports(client: TestClient, app: FastAPI) -> None:
    complete_test(client)
    for slug in (
        "metrics",
        "funnel",
        "dropoff",
        "share",
        "price",
        "utm",
        "fakedoor",
        "archetypes",
        "reports",
    ):
        r = client.get(f"/admin/export/{slug}.csv?internal=1", auth=AUTH)
        assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
        rows = list(csv.reader(io.StringIO(r.content.decode("utf-8-sig"))))
        assert len(rows) >= 2, slug
    assert client.get("/admin/export/nope.csv", auth=AUTH).status_code == 404


@pytest.mark.parametrize("query", ["from=31-10-2026", "price=abc"])
def test_admin_bad_filters(client: TestClient, query: str) -> None:
    assert client.get(f"/admin?{query}", auth=AUTH).status_code == 400


def test_admin_reports_counter(client: TestClient, app: FastAPI) -> None:
    app.state.report_service.provider = MockLLMProvider([LLMError("down")] * 3)
    pay(client, app)
    with TestClient(app, follow_redirects=False) as second:
        pay(second, app)  # мок восстановился — второй отчёт сразу ready
    make_external(app)  # мок-оплата пометила сессии внутренними — снимаем для проверки
    counter = {r[0]: r[1] for r in _table(client, "reports")}
    assert counter["fallback-отчётов всего"] == 1 and counter["из них перегенерировано"] == 0

    from scripts.regenerate_reports import regenerate_all

    regenerate_all(app.state.report_service)
    counter = {r[0]: r[1] for r in _table(client, "reports")}
    assert counter["fallback-отчётов всего"] == 1 and counter["из них перегенерировано"] == 1
    assert counter["ещё на fallback"] == 0 and counter["всего отчётов"] == 2


def _table(client: TestClient, slug: str) -> list[list[str]]:
    r = client.get(f"/admin/export/{slug}.csv", auth=AUTH)
    return [
        [c if not c.isdigit() else int(c) for c in row]
        for row in list(csv.reader(io.StringIO(r.content.decode("utf-8-sig"))))[1:]
    ]


# --- Внутренние сессии ---------------------------------------------------------------------------


def test_internal_link_disabled_without_token(client: TestClient) -> None:
    assert client.get("/internal/anything").status_code == 404


def test_internal_link_sets_cookie_and_marks_session(tmp_path: Path) -> None:
    app = build_app(tmp_path, internal_link_token="team-secret")
    with TestClient(app, follow_redirects=False) as c:
        c.get("/")
        make_external(app)
        assert c.get("/internal/wrong").status_code == 404
        r = c.get("/internal/team-secret")
        assert r.status_code == 303 and "internal=1" in r.headers["set-cookie"]
    assert all(s.is_internal for s in db_rows(app, Session))


def test_internal_detection_in_production(tmp_path: Path) -> None:
    from starlette.requests import Request

    prod = make_settings(tmp_path, app_env="production")
    plain = Request({"type": "http", "headers": []})
    marked = Request({"type": "http", "headers": [(b"cookie", b"internal=1")]})
    assert is_internal_request(plain, prod) is False
    assert is_internal_request(marked, prod) is True
    assert is_internal_request(plain, make_settings(tmp_path)) is True  # не production


def test_mock_checkout_marks_session_internal(client: TestClient, app: FastAPI) -> None:
    complete_test(client)
    make_external(app)
    client.post("/checkout", data={"email": EMAIL, "agree_offer": "yes"})
    assert db_rows(app, Session)[0].is_internal is True


# --- Фейковая дверь ------------------------------------------------------------------------------


def events_named(app: FastAPI, name: str) -> list[Event]:
    return [e for e in db_rows(app, Event) if e.name == name]


def test_tracker_card_on_report(client: TestClient, app: FastAPI) -> None:
    pay(client, app)
    html = client.get(f"/report/{report_token(app)}").text
    assert "Трекер счастья" in html and "390 ₽/мес" in html and ">Хочу<" in html


def test_fakedoor_click_and_lead_from_another_device(client: TestClient, app: FastAPI) -> None:
    order = pay(client, app)
    token = report_token(app)
    with TestClient(app) as other_device:  # ссылка из письма, cookie покупателя нет
        r = other_device.post(f"/report/{token}/tracker", headers={"HX-Request": "true"})
        assert r.status_code == 200 and "Оставь email" in r.text and 'role="dialog"' in r.text
        r = other_device.post(
            "/lead",
            data={"token": token, "email": " Lead@Example.ru ", "agree": "yes"},
            headers={"HX-Request": "true"},
        )
        assert "Спасибо" in r.text
    [click] = events_named(app, "sub_fakedoor_click")
    [submit] = events_named(app, "sub_email_submit")
    assert click.session_id == submit.session_id == order.session_id
    [lead] = db_rows(app, Lead)
    cipher = app.state.email_cipher
    assert lead.source == "sub_fakedoor" and lead.consent_at is not None
    assert cipher.decrypt(lead.email_encrypted) == "lead@example.ru"
    assert "lead@" not in lead.email_encrypted


def test_duplicate_lead_counted_once(client: TestClient, app: FastAPI) -> None:
    pay(client, app)
    for _ in range(2):
        client.post("/lead", data={"token": report_token(app), "email": "a@b.ru", "agree": "yes"})
    assert len(db_rows(app, Lead)) == 1 and len(events_named(app, "sub_email_submit")) == 1


@pytest.mark.parametrize(
    ("data", "error"),
    [({"email": "bad", "agree": "yes"}, "Проверь email"), ({"email": "a@b.ru"}, "Отметь согласие")],
)
def test_lead_validation(client: TestClient, app: FastAPI, data, error) -> None:
    pay(client, app)
    r = client.post(
        "/lead", data={"token": report_token(app), **data}, headers={"HX-Request": "true"}
    )
    assert r.status_code == 422 and error in r.text and db_rows(app, Lead) == []


def test_lead_without_htmx_renders_page(client: TestClient, app: FastAPI) -> None:
    pay(client, app)
    r = client.post("/lead", data={"token": report_token(app), "email": "a@b.ru", "agree": "yes"})
    assert "<html" in r.text and "Вернуться к отчёту" in r.text


def test_fakedoor_unknown_token(client: TestClient) -> None:
    assert client.post("/report/nope/tracker").status_code == 404
    assert (
        client.post("/lead", data={"token": "nope", "email": "a@b.ru", "agree": "yes"}).status_code
        == 404
    )


# --- Сид-скрипт и дашборд на тестовых данных -----------------------------------------------------


def test_seed_demo_fills_dashboard(app: FastAPI, client: TestClient, monkeypatch) -> None:
    import random

    from scripts.seed_demo import seed

    counts = seed(app, 4000, random.Random(42))
    assert counts["sessions"] == 4000 and counts["reports"] > 0 and counts["leads"] > 0
    html = client.get("/admin", auth=AUTH).text
    for name in ("Дохождение", "Шеринг", "Конверсия в покупку", "Интерес к подписке"):
        assert f'data-metric="{name}"' in html
    assert 'data-color="green"' in html  # дохождение ≈ 70% при n≈1000 — уверенно выше 60%
    reports = {r[0]: r[1] for r in _table(client, "reports")}
    assert reports["из них перегенерировано"] > 0
    internal = client.get("/admin?internal=1", auth=AUTH).text
    assert internal != html


def test_seed_refuses_production(tmp_path: Path, monkeypatch) -> None:
    from scripts import seed_demo

    class FakeApp:
        class state:
            settings = make_settings(tmp_path, app_env="production")

    monkeypatch.setattr("app.main.create_app", lambda: FakeApp)
    with pytest.raises(SystemExit, match="production"):
        seed_demo.main(["--sessions", "1"])


def test_period_boundaries_in_moscow_time(app: FastAPI) -> None:
    moscow = ZoneInfo("Europe/Moscow")
    late_evening = datetime(2026, 10, 30, 23, 30, tzinfo=moscow)  # по UTC это ещё 30-е 20:30
    after_midnight = datetime(2026, 10, 31, 0, 30, tzinfo=moscow)  # по UTC — 30-е 21:30
    with app.state.session_factory() as db:
        db.add_all(
            [
                Session(sid_hash="a" * 64, created_at=late_evening),
                Session(sid_hash="b" * 64, created_at=after_midnight),
            ]
        )
        db.commit()
        oct31 = date(2026, 10, 31)
        assert len(load_facts(db, Filters(date_from=oct31, date_to=oct31))) == 1
        assert len(load_facts(db, Filters(date_to=date(2026, 10, 30)))) == 1


def test_created_at_filter_uses_session_date(app: FastAPI) -> None:
    with app.state.session_factory() as db:
        old = Session(sid_hash="x" * 64, created_at=datetime.now(UTC) - timedelta(days=30))
        db.add(old)
        db.commit()
        assert len(load_facts(db, Filters(date_from=date.today() - timedelta(days=7)))) == 0
        assert len(load_facts(db, Filters())) == 1


def test_seed_can_run_twice(app: FastAPI) -> None:
    import random

    from scripts.seed_demo import seed

    seed(app, 300, random.Random(1))
    seed(app, 300, random.Random(1))  # повторный запуск на непустой базе не падает
    assert len(db_rows(app, Session)) == 600
